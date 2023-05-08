# hybridclr技术原理剖析

我们在[上一节](./2.1.2_%E5%85%B3%E4%BA%8Ehybridclr%E5%8F%AF%E8%A1%8C%E6%80%A7%E7%9A%84%E6%80%9D%E7%BB%B4%E5%AE%9E%E9%AA%8C.md)完成了hybridclr可行性分析。由于hybridclr内容极多，限于篇幅本篇文章主要概述性介绍hybridclr的技术实现。

## CLR和il2cpp基础

给纯AOT的il2cpp运行时添加一个原生interpreter模块，最终实现[hybrid mode execution](https://developpaper.com/new-net-interpreter-mono-has-arrived/)，这看起来是非常复杂的事情。

其实不然，程序不外乎代码+数据。CLR运行中做的事情，综合起来主要就几种：

1. 执行简单的内存操作或者计算或者逻辑跳转。这部分与CLI的Base指令集大致对应
2. 执行一个依赖于元数据信息的基础操作。例如 `a.x, arr[3]` 这种，依赖于元数据信息才能正确工作的代码。对应部分CLI的Object Model指令集。
3. 执行一个依赖元数据的较复杂的操作。如 `typeof(object)，a is string、(object)5` 这种依赖于运行时提供的函数及相应元数据才正确工作的代码。对应部分CLI的Object Model指令集。
4. 函数调用。包括且不限于被AOT函数调用及调用AOT函数，及interpreter之间的函数调用。对应CLI指令集中的 `call、callvir、newobj` 等Object Model指令。

如果对CLR有深入的了解和透彻的分析，为了实现`hybrid mode execution`，hybridclr核心要完成的就以下两件事，其他则是无碍全局的细节：

- assembly信息能够加载和注册。 在此基础可以实现 `1-3`。
- 确保interpreter函数能被找到并且被调用，并且能执行出正确的结果。则可以实现 `4`。

由于彻底理解以上内容需要较丰富的对CLR的认知以及较强的洞察力，我们不再费口舌解释，不能理解的开发者不必深究，继续看后续章节。

## 核心模块

从功能来看包含以下核心部分：

- metadata初级解析
- metadata高级元数据结构解析
- metadata动态注册
- 寄存器指令集设计
- IL指令集到hybridclr寄存器指令集的转换
- 解释执行hybridclr指令集
- 其他如GC、多线程相关处理

从代码结构来看包含三个目录：

- metadata 元数据相关
- transform 指令集转换相关
- interpreter 解释器相关

## metadata 初级解析

这部分内容技术门槛不高，但比较琐碎和辛苦，忠实地按照 [ECMA-335规范](https://www.ecma-international.org/publications-and-standards/standards/ecma-335/) 的文档实现即可。对于少量有疑惑的地方，可以网上的资料或者借鉴mono的代码。

相关代码在`hybridclr\metadata`目录，主要在RawImage.h和RawImage.cpp中实现。如果再细分，相关实现分为以下几个部分。

### PE 文件结构解析

managed dll扩展了PE文件结构，增加了CLI相关metadata部分。这环节的主要工作有：

- 解析PE headers
- 解析 section headers，找出CLI header，定位出cli数据段
- 解析出所有stream。Stream是CLI中最底层的数据结构之一，CLI将元数据根据特性分为几个大类
  - #~ 流。包含所有tables定义，是最核心的元数据结构
  - #Strings 流。包括代码中非文档类型的字符串，如类型名、字段名等等
  - #GUID 流
  - #Blob 流。一些元数据类型过于复杂，以blob格式保存。还有一些数据如数组初始化数据列表，也常常保存到Blob流。
  - #- 流
  - #Pdb 流。用于调试

解析PE文件和代码在RawImage::Load，解析stream对应的代码在RawImage::LoadStreams。

### tables metadata 解析

CLI中大多数metadata被为几十种类型，每个类型的数据组织成一个table。对于每个table，每行记录都是相同大小。

初级解析中不解析table中每行记录，只解析table的每行记录大小和每个字段偏移。有一大类字段为Coded Index类型，有可能是2或4字节，并不固定，需要根据其他表的Row Count来决定table中这一列的字段大小。由于table很多，这个计算过程比较琐碎易错。

对应代码在RawImage::LoadTables，截取部分代码如下

```cpp
void RawImage::BuildTableRowMetas()
{
    {
        auto& table = _tableRowMetas[(int)TableType::MODULE];
        table.push_back({ 2 });
        table.push_back({ ComputStringIndexByte() });
        table.push_back({ ComputGUIDIndexByte() });
        table.push_back({ ComputGUIDIndexByte() });
        table.push_back({ ComputGUIDIndexByte() });
    }
    {
        auto& table = _tableRowMetas[(int)TableType::TYPEREF];
        table.push_back({ ComputTableIndexByte(TableType::MODULE, TableType::MODULEREF, TableType::ASSEMBLYREF, TableType::TYPEREF, TagBits::ResoulutionScope) });
        table.push_back({ ComputStringIndexByte() });
        table.push_back({ ComputStringIndexByte() });
    }

    // ... 其他
}

```

### table 解析

上一节已经解析出每个table的起始数据位置、row count、表中每个字段的偏移和大小，有足够的信息可以解析出每个table中任意row的数据。table中row的id从1开始。

每个table的row的解析方式根据ECMA规范实现即可。每个table的row定义在 `metadata\Coff.h`文件，Row解析代码在 `RawImage.h`。这些解析代码都非常相似，为了避免错误，使用了大量的宏，截取部分代码如下：

```cpp
TABLE2(GenericParamConstraint, TableType::GENERICPARAMCONSTRAINT, owner, constraint)
TABLE3(MemberRef, TableType::MEMBERREF, classIdx, name, signature)
TABLE1(StandAloneSig, TableType::STANDALONESIG, signature)
TABLE3(MethodImpl, TableType::METHODIMPL, classIdx, methodBody, methodDeclaration)
TABLE2(FieldRVA, TableType::FIELDRVA, rva, field)
TABLE2(FieldLayout, TableType::FIELDLAYOUT, offset, field)
TABLE3(Constant, TableType::CONSTANT, type, parent, value)
TABLE2(MethodSpec, TableType::METHODSPEC, method, instantiation)
TABLE3(CustomAttribute, TableType::CUSTOMATTRIBUTE, parent, type, value)

```

## metadata高级元数据结构解析

从tables里直接读出来的都是持久化的初始metadata，而运行时需要的不只是这些简单原始数据，经常需要进一步resolve后的数据。例如

- Il2CppType 。即可以是简单的 `int`，也可以是比较复杂的`List<int>`，甚至是特别复杂的`List<(int,int)>&`
- MethodInfo 。 即可以是简单的`object.ToString`，也有复杂的泛型 `IEnumerator<int>.Count`。

CLI的泛型机制导致元数据变得极其复杂，典型的是TypeSpec，MethodSpec，MemberSpec相关元数据的运行时解析。核心实现代码在Image.cpp中实现，剩余一部分在 InterpreterImage.cpp及AOTHomologousImage.cpp中实现。后面会有专门介绍。

## metadata动态注册

根据粒度从大到小，主要分为以下几类

- Assembly 注册。即将加载的assembly注册到il2cpp的元数据管理中。
- TypeDefinition 注册。 这一步会生成基础运行时类型 Il2CppClass。
- VTable虚表计算。 由于il2cpp的虚表计算是个黑盒，内部相当复杂，我们费了很多功夫才研究明白它的计算机制。后面会有专门章节介绍VTable计算，这儿不再赘述。
- 其他元数据，如CustomAttribute计算等等。

### Assembly 注册

Assembly加载的关键函数在 il2cpp::vm::MetadataCache::LoadAssemblyFromBytes 。由于il2cpp是AOT运行时，原始实现只是简单地抛出异常。我们修改和完善了实现，在其中调用了hybridclr::metadata::Assembly::LoadFromBytes，完成了Assembly的创建，然后再注册到全局Assemblies列表。相关代码实现如下：

```cpp
const Il2CppAssembly* il2cpp::vm::MetadataCache::LoadAssemblyFromBytes(const char* assemblyBytes, size_t length)
{
    il2cpp::os::FastAutoLock lock(&il2cpp::vm::g_MetadataLock);

    Il2CppAssembly* newAssembly = hybridclr::metadata::Assembly::LoadFromBytes(assemblyBytes, length, true);
    if (newAssembly)
    {
        // avoid register placeholder assembly twicely.
        for (Il2CppAssembly* ass : s_cliAssemblies)
        {
            if (ass == newAssembly)
            {
                return ass;
            }
        }
        il2cpp::vm::Assembly::Register(newAssembly);
        s_cliAssemblies.push_back(newAssembly);
        return newAssembly;
    }

    return nullptr;
}
```

### TypeDefinition 注册

Assembly使用了延迟初始化方式，注册后Assembly中的类型信息并未创建相应的运行时metadata Il2CppClass，只有当第一次访问到该类型时才进行初始化。

由于交叉依赖以及为了优化性能，Il2Class的创建是个分步过程

- Il2CppClass 基础创建
- Il2CppClass的子元数据延迟初始化
- 运行时Class初始化

#### Il2CppClass基础创建

在上一节加载Assembly时已经创建好所有类型对应的定义数据Il2CppTypeDefinition，在 il2cpp::vm::GlobalMetadata::FromTypeDefinition 中完成Il2CppClass创建工作。代码如下：

```cpp
Il2CppClass* il2cpp::vm::GlobalMetadata::FromTypeDefinition(TypeDefinitionIndex index)
{
    /// ... 省略其他
    Il2CppClass* typeInfo = (Il2CppClass*)IL2CPP_CALLOC(1, sizeof(Il2CppClass) + (sizeof(VirtualInvokeData) * typeDefinition->vtable_count));
    typeInfo->klass = typeInfo;
    typeInfo->image = GetImageForTypeDefinitionIndex(index);
    typeInfo->name = il2cpp::vm::GlobalMetadata::GetStringFromIndex(typeDefinition->nameIndex);
    typeInfo->namespaze = il2cpp::vm::GlobalMetadata::GetStringFromIndex(typeDefinition->namespaceIndex);
    typeInfo->byval_arg = *il2cpp::vm::GlobalMetadata::GetIl2CppTypeFromIndex(typeDefinition->byvalTypeIndex);
    typeInfo->this_arg = typeInfo->byval_arg;
    typeInfo->this_arg.byref = true;
    typeInfo->typeMetadataHandle = reinterpret_cast<const Il2CppMetadataTypeHandle>(typeDefinition);
    typeInfo->genericContainerHandle = GetGenericContainerFromIndex(typeDefinition->genericContainerIndex);
    typeInfo->instance_size = typeDefinitionSizes->instance_size;
    typeInfo->actualSize = typeDefinitionSizes->instance_size;     // actualySize is instance_size for compiler generated values
    typeInfo->native_size = typeDefinitionSizes->native_size;
    typeInfo->static_fields_size = typeDefinitionSizes->static_fields_size;
    typeInfo->thread_static_fields_size = typeDefinitionSizes->thread_static_fields_size;
    typeInfo->thread_static_fields_offset = -1;
    typeInfo->flags = typeDefinition->flags;
    typeInfo->valuetype = (typeDefinition->bitfield >> (kBitIsValueType - 1)) & 0x1;
    typeInfo->enumtype = (typeDefinition->bitfield >> (kBitIsEnum - 1)) & 0x1;
    typeInfo->is_generic = typeDefinition->genericContainerIndex != kGenericContainerIndexInvalid;     // generic if we have a generic container
    typeInfo->has_finalize = (typeDefinition->bitfield >> (kBitHasFinalizer - 1)) & 0x1;
    typeInfo->has_cctor = (typeDefinition->bitfield >> (kBitHasStaticConstructor - 1)) & 0x1;
    typeInfo->is_blittable = (typeDefinition->bitfield >> (kBitIsBlittable - 1)) & 0x1;
    typeInfo->is_import_or_windows_runtime = (typeDefinition->bitfield >> (kBitIsImportOrWindowsRuntime - 1)) & 0x1;
    typeInfo->packingSize = ConvertPackingSizeEnumToValue(static_cast<PackingSize>((typeDefinition->bitfield >> (kPackingSize - 1)) & 0xF));
    typeInfo->method_count = typeDefinition->method_count;
    typeInfo->property_count = typeDefinition->property_count;
    typeInfo->field_count = typeDefinition->field_count;
    typeInfo->event_count = typeDefinition->event_count;
    typeInfo->nested_type_count = typeDefinition->nested_type_count;
    typeInfo->vtable_count = typeDefinition->vtable_count;
    typeInfo->interfaces_count = typeDefinition->interfaces_count;
    typeInfo->interface_offsets_count = typeDefinition->interface_offsets_count;
    typeInfo->token = typeDefinition->token;
    typeInfo->interopData = il2cpp::vm::MetadataCache::GetInteropDataForType(&typeInfo->byval_arg);

    // 省略其他

    return typeInfo;
}
```

可以看到TypeDefinition中字段相当多，这些都是在Assembly加载环节计算好的。

#### Il2CppClass的子metadata延迟初始化

由于交互依赖以及为了优化性能，Il2Class的子metadata数据使用了延迟初始化策略，分步进行，在第一次使用时才初始化。以下代码截取自 `Class.h` 文件：

```cpp
class Class
{
    // ... 其他代码
    static bool Init(Il2CppClass *klass);

    static void SetupEvents(Il2CppClass *klass);
    static void SetupFields(Il2CppClass *klass);
    static void SetupMethods(Il2CppClass *klass);
    static void SetupNestedTypes(Il2CppClass *klass);
    static void SetupProperties(Il2CppClass *klass);
    static void SetupTypeHierarchy(Il2CppClass *klass);
    static void SetupInterfaces(Il2CppClass *klass);
    // ... 其他代码
};

```

重点来了！！！函数metadata的执行指针的绑定在SetupMethods函数中完成，其中关键代码片段如下：

```cpp
void SetupMethodsLocked(Il2CppClass *klass, const il2cpp::os::FastAutoLock& lock)
{
    /// ... 其他忽略的代码
    for (MethodIndex index = 0; index < end; ++index)
    {
        Il2CppMetadataMethodInfo methodInfo = MetadataCache::GetMethodInfo(klass, index);

        newMethod->name = methodInfo.name;

        if (klass->valuetype)
        {
            Il2CppMethodPointer adjustorThunk = MetadataCache::GetAdjustorThunk(klass->image, methodInfo.token);
            if (adjustorThunk != NULL)
                newMethod->methodPointer = adjustorThunk;
        }

        // We did not find an adjustor thunk, or maybe did not need to look for one. Let's get the real method pointer.
        if (newMethod->methodPointer == NULL)
            newMethod->methodPointer = MetadataCache::GetMethodPointer(klass->image, methodInfo.token);

        newMethod->invoker_method = MetadataCache::GetMethodInvoker(klass->image, methodInfo.token);
    }
    /// ... 其他忽略的代码
}
```

函数运行时元数据结构为 MethodInfo，定义如下,

```cpp
typedef struct MethodInfo
{
    Il2CppMethodPointer methodPointer;
    InvokerMethod invoker_method;
    const char* name;
    Il2CppClass *klass;
    const Il2CppType *return_type;
    const ParameterInfo* parameters;

    // ... 省略其他
} MethodInfo;

```

其中我们比较关心的是methodPointer和invoker_method这两个字段。 methodPointer指向普通执行函数，invoker_method指向反射执行函数。

我们以 methodPointer为例，进一步跟踪它的设置过程， `il2cpp::vm::MetadataCache::GetMethodPointer` 的实现如下：

```cpp
Il2CppMethodPointer il2cpp::vm::MetadataCache::GetMethodPointer(const Il2CppImage* image, uint32_t token)
{
    uint32_t rid = GetTokenRowId(token);
    uint32_t table =  GetTokenType(token);
    if (rid == 0)
        return NULL;

    // ==={{ hybridclr
    if (hybridclr::metadata::IsInterpreterImage(image))
    {
        return hybridclr::metadata::MetadataModule::GetMethodPointer(image, token);
    }
    // ===}} hybridclr

    IL2CPP_ASSERT(rid <= image->codeGenModule->methodPointerCount);

    return image->codeGenModule->methodPointers[rid - 1];
}
```

可以看出，如果是解释器assembly，就跳转到解释器元数据模块获得对应的MethodPointer指针。 继续跟踪，相关代码如下：

```cpp

Il2CppMethodPointer InterpreterImage::GetMethodPointer(uint32_t token)
{
    uint32_t methodIndex = DecodeTokenRowIndex(token) - 1;
    IL2CPP_ASSERT(methodIndex < (uint32_t)_methodDefines.size());
    const Il2CppMethodDefinition* methodDef = &_methodDefines[methodIndex];
    return hybridclr::interpreter::InterpreterModule::GetMethodPointer(methodDef);
}

Il2CppMethodPointer InterpreterModule::GetMethodPointer(const Il2CppMethodDefinition* method)
{
    const NativeCallMethod* ncm = GetNativeCallMethod(method, false);
    if (ncm)
    {
        return ncm->method;
    }
    //RaiseMethodNotSupportException(method, "GetMethodPointer");
    return (Il2CppMethodPointer)NotSupportNative2Managed;
}

// interpreter/InterpreterModule.cpp
template<typename T>
const NativeCallMethod* GetNativeCallMethod(const T* method, bool forceStatic)
{
    char sigName[1000];
    ComputeSignature(method, !forceStatic, sigName, sizeof(sigName) - 1);
    auto it = s_calls.find(sigName);
    return (it != s_calls.end()) ? &it->second : nullptr;
}

// s_calls 定义
static std::unordered_map<const char*, NativeCallMethod, CStringHash, CStringEqualTo> s_calls;

void InterpreterModule::Initialize()
{
    for (size_t i = 0; ; i++)
    {
        NativeCallMethod& method = g_callStub[i];
        if (!method.signature)
        {
            break;
        }
        s_calls.insert({ method.signature, method });
    }

    for (size_t i = 0; ; i++)
    {
        NativeInvokeMethod& method = g_invokeStub[i];
        if (!method.signature)
        {
            break;
        }
        s_invokes.insert({ method.signature, method });
    }
}
```

这儿根据函数定义计算其签名并且返回了一个函数指针，这个函数指针是什么呢？ s_calls在InterpreterModule::Initialize中使用g_callStub初始化。那g_calStub又是什么呢？它在 `interpreter/MethodBridge_xxx.cpp` 中定义，原来是桥接函数相关的数据结构！

为什么要返回一个这样的函数，而不是直接将methodPointer指向 `InterpreterModule::Execute` 函数呢？ 以 `int Foo::Sum(int,int)` 函数为例，这个函数的实际的签名为 `int32_t (int32_t, int32_t, MethodInfo*)`，在调用这个methodPointer函数时，调用方一定会传递这三个参数。这些参数每个函数都不一样，如果直接指向 `InterpreterModule::Execute` 函数，由于ABI调用无法自省（就算可以，性能也比较差），Execute函数既无法提取出普通参数，也无法提取出MethodInfo*参数，因而无法正确运行。因此需要对每个函数，适当地将ABI调用中的这些参数传递给Execute函数。

桥接函数如其名，承担了native ABI函数参数和interpreter函数之间双向的参数的转换作用。截取一段示例代码：

```cpp

/// AOT 到 interpreter 的调用参数转换
static int64_t __Native2ManagedCall_i8srr8sr(void* __arg0, double __arg1, void* __arg2, const MethodInfo* method)
{
    StackObject args[4] = {*(void**)&__arg0, *(void**)&__arg1, *(void**)&__arg2 };
    StackObject* ret = args + 3;
    Interpreter::Execute(method, args, ret);
    return *(int64_t*)ret;
}

// interpreter 到 AOT 的调用参数转换
static void __Managed2NativeCall_i8srr8sr(const MethodInfo* method, uint16_t* argVarIndexs, StackObject* localVarBase, void* ret)
{
    if (hybridclr::metadata::IsInstanceMethod(method) && !localVarBase[argVarIndexs[0]].obj)
    {
        il2cpp::vm::Exception::RaiseNullReferenceException();
    }
    Interpreter::RuntimeClassCCtorInit(method);
    typedef int64_t (*NativeMethod)(void* __arg0, double __arg1, void* __arg2, const MethodInfo* method);
    *(int64_t*)ret = ((NativeMethod)(method->methodPointer))((void*)(localVarBase+argVarIndexs[0]), *(double*)(localVarBase+argVarIndexs[1]), (void*)(localVarBase+argVarIndexs[2]), method);
}
```

#### 运行时Class初始化

即程序运行过程中第一次访问类的静态字段或者函数时或者创建对象时触发的类型初始化。在il2cpp::vm::Runtime::ClassInit(klass)中完成。不是特别关键，我们后面在单独文章中介绍。

### VTable虚表计算

虚表是多态的核心。CLI的虚表计算非常复杂，但不理解它的实现并不影响开发者理解hybridclr的核心运行流程，我们后面在单独文章中介绍。

### 其他元数据

CustomAttribute使用延迟初始化方式，计算也很复杂，我们后面单独文章介绍。

## 寄存器指令集设计

直接解释原始IL指令有几个问题：

- IL是基于栈的指令，运行时维护执行栈是个无谓的开销
- IL有大量单指令多功能的指令，如add指令可以用于计算int、long、float、double类型的和，导致运行时需要根据上文判断到底该执行哪种计算。不仅增加了运行时判定的开销，还增加了运行时维护执行栈数据类型的开销
- IL指令包含一些需要运行时resolve的数据，如newobj指令第一个参数是method token。token resolve是一个开销很大的操作，每次执行都进行resolve会极大拖慢执行性能
- IL是基于栈的指令，压栈退栈相关指令数较多。像a=b+c这样的指令需要4条指令完成，而如果采用基于寄存器的指令，完全可以一条指令完成。
- IL不适合做其他优化操作，如我们的InitOnce JIT技术。
- 其他

因此我们需要将原始IL指令转换为更高效的寄存器指令。由于指令很多，这儿不介绍寄存器指令集的详细设计。以add指令举例

```cpp

// 包含type字段，即指令ID。
struct IRCommon
{
    HiOpcodeEnum type;
};

// add int, int -> int 对应的寄存器指令
struct IRBinOpVarVarVar_Add_i4 : IRCommon
{
    uint16_t ret; // 计算结果对应的 栈位置
    uint16_t op1; // 操作数1对应的栈位置
    uint16_t op2; // 操作数2对应的栈位置
};

```

## 指令集的转换

理解这节需要初步的编译原理相关知识，我们使用了非常朴素的转换算法，并且基本没有做指令优化。转换过程分为几步：

- BasicBlock 划分。 将IL指令块切成一段段不包含任何跳转指令的代码块，称之为BasicBlock。
- 模拟指令执行流程，同时使用广度优先遍历算法遍历所有BasicBlock，将每个BasicBlock转换为IRBasicBlock。

BasicBlock到IRBasicBlock转换采用了最朴素的一对一指令转换算法，转换相关代码在`transform::HiTransform::Transform`。我们以add指令为例：

```cpp

case OpcodeValue::ADD:
{
    IL2CPP_ASSERT(evalStackTop >= 2);
    EvalStackVarInfo& op1 = evalStack[evalStackTop - 2];
    EvalStackVarInfo& op2 = evalStack[evalStackTop - 1];

    CreateIR(ir, BinOpVarVarVar_Add_i4);
    ir->op1 = op1.locOffset;
    ir->op2 = op2.locOffset;
    ir->ret = op1.locOffset;

    EvalStackReduceDataType resultType;
    switch (op1.reduceType)
    {
    case EvalStackReduceDataType::I4:
    {
        switch (op2.reduceType)
        {
        case EvalStackReduceDataType::I4:
        {
            resultType = EvalStackReduceDataType::I4;
            ir->type = HiOpcodeEnum::BinOpVarVarVar_Add_i4;
            break;
        }
        case EvalStackReduceDataType::I:
        case EvalStackReduceDataType::Ref:
        {
            CreateAddIR(irConv, ConvertVarVar_i4_i8);
            irConv->dst = irConv->src = op1.locOffset;

            resultType = op2.reduceType;
            ir->type = HiOpcodeEnum::BinOpVarVarVar_Add_i8;
            break;
        }
        default:
        {
            IL2CPP_ASSERT(false);
            break;
        }
        }
        break;
    }
    case EvalStackReduceDataType::I8:
    {
        switch (op2.reduceType)
        {
        case EvalStackReduceDataType::I8:
        case EvalStackReduceDataType::I: // not support i8 + i ! but we support
        {
            resultType = EvalStackReduceDataType::I8;
            ir->type = HiOpcodeEnum::BinOpVarVarVar_Add_i8;
            break;
        }
        default:
        {
            IL2CPP_ASSERT(false);
            break;
        }
        }
        break;
    }
    case EvalStackReduceDataType::I:
    case EvalStackReduceDataType::Ref:
    {
        switch (op2.reduceType)
        {
        case EvalStackReduceDataType::I4:
        {
            CreateAddIR(irConv, ConvertVarVar_i4_i8);
            irConv->dst = irConv->src = op2.locOffset;

            resultType = op1.reduceType;
            ir->type = HiOpcodeEnum::BinOpVarVarVar_Add_i8;
            break;
        }
        case EvalStackReduceDataType::I:
        case EvalStackReduceDataType::I8:
        {
            resultType = op1.reduceType;
            ir->type = HiOpcodeEnum::BinOpVarVarVar_Add_i8;
            break;
        }
        default:
        {
            IL2CPP_ASSERT(false);
            break;
        }
        }
        break;
    }
    case EvalStackReduceDataType::R4:
    {
        switch (op2.reduceType)
        {
        case EvalStackReduceDataType::R4:
        {
            resultType = op2.reduceType;
            ir->type = HiOpcodeEnum::BinOpVarVarVar_Add_f4;
            break;
        }
        default:
        {
            IL2CPP_ASSERT(false);
            break;
        }
        }
        break;
    }
    case EvalStackReduceDataType::R8:
    {
        switch (op2.reduceType)
        {
        case EvalStackReduceDataType::R8:
        {
            resultType = op2.reduceType;
            ir->type = HiOpcodeEnum::BinOpVarVarVar_Add_f8;
            break;
        }
        default:
        {
            IL2CPP_ASSERT(false);
            break;
        }
        }
        break;
    }
    default:
    {
        IL2CPP_ASSERT(false);
        break;
    }
    }

    PopStack();
    op1.reduceType = resultType;
    op1.byteSize = GetSizeByReduceType(resultType);
    AddInst(ir);
    ip++;
    continue;
}

```

从代码可以看出，其实转换算法非常简单，就是根据add指令的参数类型，决定转换为哪条寄存器指令，同时正确设置指令的字段值。

## 解释执行hybridclr指令集

解释执行在代码 `interpreter::InterpreterModule::Execute` 函数中完成。涉及到几部分：

- 函数帧构建，参数、局部变量、执行栈的初始化
- 执行普通指令
- 调用子函数
- 异常处理

这块内容也很多，我们会在多篇文章中详细介绍实现，这里简单摘取 BinOpVarVarVar_Add_i4 指令的实现代码:

```cpp
case HiOpcodeEnum::BinOpVarVarVar_Add_i4:
{
    uint16_t __ret = *(uint16_t*)(ip + 2);
    uint16_t __op1 = *(uint16_t*)(ip + 4);
    uint16_t __op2 = *(uint16_t*)(ip + 6);
    (*(int32_t*)(localVarBase + __ret)) = (*(int32_t*)(localVarBase + __op1)) + (*(int32_t*)(localVarBase + __op2));
    ip += 8;
    continue;
}
```

相信这段代码还是比较好理解的。指令集转换和指令解释相关代码是hybridclr的核心，但复杂度却不高，这得感谢il2cpp运行时帮我们承担了绝大多数复杂的元数据相关操作的支持。

## 其他如GC、多线程相关处理

我们在hybridclr可行性的思维实验中分析过这两部分实现。

### GC

对于对象分配，我们使用il2cpp::vm::Object::New函数分配对象即可。还有一些其他涉及到GC的部分如ldstr指令中Il2CppString对象的缓存，利用了一些其他il2cpp运行时提供的GC机制。

### 多线程相关处理

- volatile 。对于指令中包含volatile前缀指令，我们简单在执行代码前后插入MemoryBarrier。
- ThreadStatic 。 使用il2cpp内置的Class的ThreadStatic变量机制即可。
- Thread。 我们对于每个托管线程，都创建了一个对应的解释器栈。
- async 相关。由于异步相关只是语法糖，由编译器和标准库完成了所有内容。hybridclr只需要解决其中产生的AOT泛型实例化的问题即可。

## 总结

概括地说，hybridclr的实现为：

- MetadataCache::LoadAssemblyFromBytes （c#层调用Assembly.Load时触发）时加载并注册interpreter Assembly
- il2cpp运行过程中延迟初始化类型相关元数据，其中关键为正确设置了MethodInfo元数据中methodPointer指针
- il2cpp运行时通过methodPointer或者methodInvoke指针，再经过桥接函数跳转，最终执行了Interpreter::Execute函数。
  - Execute函数在第一次执行某interpreter函数时触发HiTransform::Transform操作，将原始IL指令翻译为hybridclr的寄存器指令。
  - 然后执行该函数对应的hybridclr寄存器指令。

至此完成hybridclr的技术原理介绍。
