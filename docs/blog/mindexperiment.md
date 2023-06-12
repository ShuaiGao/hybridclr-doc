# 关于hybridclr可行性的思维实验

在确定目标，动手实现hybridclr前，有一个必须考虑的问题——我们如何确定hybridclr的可行性？

il2cpp虽然不是一个极其完整的运行时，但代码仍高达12w行，复杂度相当高，想要短期内深入了解它的实现是非常困难的。除了官方几个介绍il2cpp的博客外，几乎找不到其他文档，
而且`Hybrid mode execution` 的实现复杂度也很高。磨刀不误砍柴工，在动手前从理论上确信这套方案有极高可行性，是完全必要的。

以我们对CLR运行时的认识，要实现 `hybrid mode execution` 机制，至少要解决以下几个问题

- 能够动态注册元数据，这些动态注册的元数据必须在运行时中跟AOT元数据完全等价。
- 所有调用动态加载的assembly中函数的路径，都能定向到正确的解释器实现。包括虚函数override、delegate回调、反射调用等等。
- 解释器中的gc，必须能够与AOT部分的gc统一处理。
- 多线程相关能正常工作。包括且不限于创建Thread、async、volatile、ThreadStatic等等。

我们下面一一分析解决这些问题。

## 动态注册元数据

我们大略地分析了il2cpp元数据初始化相关代码，得出以下结论。

首先，动态修改globalmetadata.dat这个方式不可行。因为globalmetadata.dat保存了持久化的元数据，元数据之间关系大量使用id来相互引用，添加新的数据很容易引入错误，变成极难检测的bug。另外，globalmetadata里有不少数据项由于没有文档，无法分析实际用途，也不得而知如何设置正确的值。另外，运行时会动态加载新的dll，重新计算globalmetadata.dat是成本高昂的事情。而且il2cpp中元数据管理并不支持二次加载，重复加载globalmetadata.dat会产生相当大的代码改动。

一个较可行办法，修改所有元数据访问的底层函数，检查被访问的元数据的类型，如果是AOT元数据，则保持之前的调用，如果来自动态加载，则跳转到hybridclr的元数据管理模块，返回一个恰当的值。但这儿又遇到一个问题，其次globalmetadata为了优化性能，所有dll中的元数据在统一的id命名空间下。很多元数据查询操作仅仅使用一个id参数，如何根据id区别出到底是AOT还是interpreter的元数据？

我们发现实际项目生成的globalmetadata.dat中这些元数据id的值都较小，最大也不过几十万级别。思考后用一个技巧：我们将id分成两部分: 高位为image id，低位为实际上的id，将image id=0保留给AOT元数据使用。我们为每个动态加载的dll分配一个image id，这个image中解析出的所有元数据id的高位为相应的image id。

我们通过这个技巧，hook了所有底层访问元数据的方法。大约修改了几十处，基本都是如下这样的代码，尽量不修改原始逻辑，很容易保证正确性。

```cpp
const char* il2cpp::vm::GlobalMetadata::GetStringFromIndex(StringIndex index)
{
    // ==={{ hybridclr
    if (hybridclr::metadata::IsInterpreterIndex(index))
    {
        return hybridclr::metadata::MetadataModule::GetStringFromEncodeIndex(index);
    }
    // ===}} hybridclr
    IL2CPP_ASSERT(index <= s_GlobalMetadataHeader->stringSize);
    const char* strings = MetadataOffset<const char*>(s_GlobalMetadata, s_GlobalMetadataHeader->stringOffset, index);
    #if __ENABLE_UNITY_PLUGIN__
        if (g_get_string != NULL)
        {
            g_get_string((char*)strings, index);
        }
    #endif // __ENABLE_UNITY_PLUGIN__
        return strings;
}

```

我们在动手前检查了多个相关函数，基本没有问题。虽然不敢确定这一定是可行的，但元数据加载是hybridclr第一阶段的开发任务，万一发现问题，及时中止hybridclr开发损失不大。于是我们认为算是解决了第一个问题。

## 所有调用动态加载的assembly中函数的路径，都能定向到正确的解释器实现

我们分析了il2cpp中关于Method元数据的管理方式，发现MethodInfo结构中保存了运行时实际执行逻辑的函数指针。如果我们简单地设置动态加载的函数元数据的MethodInfo结构的指针为正确的解释器函数，能否保证所有流程对该函数的调用，都能正确定向到解释器函数呢？

严谨思考后的结论是肯定的。首先AOT部分不可能直接调用动态加载的dll中的函数。其次，运行时并没有其他地方保存了函数指针。意味着，如果想调用动态加载的函数，必须获得MethodInfo中的函数指针，才能正确执行到目标函数。意味着我们运行过程中所有对该函数的调用一定会调用到正确的解释器函数。

至于我们解决了第二个问题。

## 解释器中的gc，必须能够与AOT部分的gc统一处理

很容易观察到，通过il2cpp::vm::Object::New可以分配托管对象，通过gc模块的函数可以分配一些能够被gc自动管理的内存。但我们如何保证，使用这种方式就一定能保存正确性呢，会不会有特殊的使用规则 ，hybridclr的解释器代码无法与之配合工作呢？

考虑到AOT代码中也有很多gc相关的操作，我们检查了一些il2cpp为这些操作生成的c++代码，都是简简单单直接调用 il2cpp::vm::Object::New 之类的函数，并无特殊之处。 可以这么分析：il2cpp生成的代码是普通的c++代码，hybridclr解释器代码也是c++代码，既然生成的代码的内存使用方式能够正确工作，那么hybridclr解释器中gc相关代码，肯定也能正确工作。

至此，我们解决了第三个问题。

## 多线程相关代码能正常工作

与上一个问题相似。我们检查了il2cpp生成的c++代码，发现并无特殊之处也能在多线程环境下正常运行，那我们也可以非常确信，hybridclr解释器的代码只要符合常规的多线程的要求，也能在多线程环境下正常运行。

至此，我们解决了第四个问题。

## 总结

我们通过少量的对实际il2cpp代码的观察，以及对CLR运行时原理的了解，再配合思维实验，可以99.9%以上确定，既然il2cpp生成的代码都能在运行时正确运行，那hybridclr解释模式下执行的代码，也能正确运行。

我们在完成思维实验的那一刻，难掩内心激动的心情。作为一名物理专业的IT人，脑海里第一时间浮现出爱因斯坦在思考广义相对论时的，使用电梯思维实验得出引力使时空弯曲这一惊人结论。我们不敢比肩这种伟大的科学家，但我们确实在使用类似的思维技巧。可以说，hybridclr不是简单的经验总结，是深刻洞察力与分析能力孕育的结果。
